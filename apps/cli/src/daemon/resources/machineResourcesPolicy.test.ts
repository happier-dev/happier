import { describe, expect, it } from 'vitest';
import { createMachineResourcesPolicyRuntime } from './machineResourcesPolicy';

describe('daemon resources policy reader', () => {
  it('publishes monitoring-key changes without notifying that key for unrelated policy or revision changes', async () => {
    let metadata: Record<string, unknown> = {};
    let revision = 1;
    let available = true;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => available ? { status: 'ready', metadata, metadataVersion: revision } : { status: 'unavailable' },
      compareAndSwap: async input => { metadata = input.metadata; revision++; return { status: 'applied', metadata, metadataVersion: revision }; },
    } });
    let publications = 0;
    const release = runtime.subscribeKey('monitoring', () => { publications++; });
    try {
      await runtime.reload(); expect(publications).toBe(1);
      await runtime.set({ expectedRevision: revision, patch: { alerts: { cpu: { enabled: true } } } });
      await runtime.set({ expectedRevision: revision, patch: { monitoring: { intervalMs: 2_000 } } });
      revision++; await runtime.reload();
      expect(publications).toBe(1);
      await runtime.set({ expectedRevision: revision, patch: { monitoring: { mode: 'off' } } });
      expect(publications).toBe(2);
      await runtime.reload(); expect(publications).toBe(2);
      available = false; await runtime.reload(); expect(publications).toBe(3);
      await runtime.reload(); expect(publications).toBe(3);
      release();
      available = true; await runtime.reload(); expect(publications).toBe(3);
    } finally { release(); runtime.stop(); }
  });
  it('publishes the acknowledged policy without waiting for another metadata read or reapplying the same receipt', async () => {
    let acknowledged = false;
    let metadata: Record<string, unknown> = {};
    let revision = 1;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => acknowledged ? { status: 'unavailable' } : { status: 'ready', metadata, metadataVersion: revision },
      compareAndSwap: async input => {
        acknowledged = true; metadata = input.metadata; revision++;
        return { status: 'applied', metadata, metadataVersion: revision };
      },
    } });
    await runtime.reload();
    const applied: unknown[] = [];
    const release = runtime.subscribe(() => applied.push(runtime.read()));
    expect(await runtime.set({ expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } })).toMatchObject({ status: 'applied', revision: 2 });
    expect(runtime.read()).toMatchObject({ status: 'ready', revision: 2, policy: { alerts: { cpu: { enabled: true } } } });
    acknowledged = false;
    await runtime.reload();
    expect(applied).toHaveLength(1);
    release(); runtime.stop();
  });
  it('refuses a session ceiling on an unsupported machine without creating a second policy writer', async () => {
    let writes = 0;
    const runtime = createMachineResourcesPolicyRuntime({ readGuardCeilingCapability: async () => ({ status: 'unavailable', reason: 'not_linux' }), port: {
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      compareAndSwap: async ({ metadata }) => { writes++; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    expect(await runtime.set({ expectedRevision: 1, patch: { guard: { sessionMemoryCeiling: { bytes: 1024 } } } }))
      .toEqual({ status: 'unsupported', reason: 'not_linux' });
    expect(writes).toBe(0);
    expect(await runtime.set({ expectedRevision: 1, patch: { guard: { sessionMemoryCeiling: { bytes: null } } } })).toMatchObject({ status: 'unchanged' });
    runtime.stop();
  });
  it('does not let a pending older reload replace a committed receipt', async () => {
    let release!: (value: { status: 'ready'; metadata: Record<string, unknown>; metadataVersion: number }) => void;
    const old = new Promise<{ status: 'ready'; metadata: Record<string, unknown>; metadataVersion: number }>(resolve => { release = resolve; });
    let first = true;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { if (first) { first = false; return old; } return { status: 'ready', metadata: {}, metadataVersion: 1 }; },
      compareAndSwap: async ({ metadata }) => ({ status: 'applied', metadata, metadataVersion: 2 }),
    } });
    const stale = runtime.reload();
    try {
      await runtime.set({ expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } });
      release({ status: 'ready', metadata: {}, metadataVersion: 1 }); await stale;
      expect(runtime.read()).toMatchObject({ status: 'ready', revision: 2, policy: { alerts: { cpu: { enabled: true } } } });
    } finally { runtime.stop(); }
  });

  it('retires the readable policy when the metadata content key locks at the CAS boundary', async () => {
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      compareAndSwap: async () => ({ status: 'locked' }),
    } });
    await runtime.reload();
    expect(await runtime.set({ expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } })).toMatchObject({ status: 'unavailable', reason: 'locked' });
    expect(runtime.read()).toEqual({ status: 'locked' });
    runtime.stop();
  });
  it.each([1, 0])('returns the admitted no-write policy receipt without reauthorization: expected revision %s', async expectedRevision => {
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      compareAndSwap: async () => { throw new Error('A no-write operation must not write'); },
    } });
    let verifications = 0;
    const options = { signal: new AbortController().signal, verifyCurrent: async () => { verifications++; return false; } };
    expect(await runtime.set({ expectedRevision, patch: {} }, options))
      .toMatchObject({ status: expectedRevision === 1 ? 'unchanged' : 'conflict', revision: 1 });
    expect(verifications).toBe(0);
    runtime.stop();
  });
  it('reloads on metadata changes without manufacturing defaults from malformed retained data', async () => {
    let metadata: Record<string, unknown> = {};
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadata, metadataVersion: 1 }),
      compareAndSwap: async () => ({ status: 'unavailable' }),
    } });
    await runtime.reload();
    expect(runtime.read()).toMatchObject({ status: 'ready', policy: { alerts: { cpu: { abovePct: 90 } } } });
    metadata = { resourcesPolicyV1: { v: 1, alerts: { cpu: { abovePct: 82 } } } };
    await runtime.reload();
    expect(runtime.read()).toMatchObject({ status: 'ready', policy: { alerts: { cpu: { abovePct: 82 } } } });
    metadata = { resourcesPolicyV1: { v: 1, alerts: { cpu: { abovePct: 110 } } } };
    await runtime.reload();
    expect(runtime.read()).toEqual({ status: 'invalid' });
    expect(await runtime.set({ expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } })).toEqual({ status: 'unavailable', reason: 'invalid' });
    runtime.stop();
    await runtime.reload();
    expect(runtime.read()).toEqual({ status: 'unavailable' });
  });

  it('bounds an absolute disk threshold by reported capacity and refuses unknown capacity', async () => {
    let capacity: readonly number[] = [];
    let writes = 0;
    const runtime = createMachineResourcesPolicyRuntime({ readVolumeCapacityBytes: () => capacity, port: {
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      compareAndSwap: async ({ metadata }) => { writes++; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    const input = (freeBytes: number) => ({ expectedRevision: 1, patch: { alerts: { disk: { threshold: { freeBytes } } } } });
    expect(await runtime.set(input(100))).toEqual({ status: 'unavailable', reason: 'volume_capacity_unavailable' });
    capacity = [50, 100];
    expect(await runtime.set(input(101))).toEqual({ status: 'unsupported', reason: 'disk_threshold_exceeds_volume_capacity' });
    expect(await runtime.set(input(100))).toMatchObject({ status: 'applied' });
    expect(writes).toBe(1);
    runtime.stop();
  });

  it('does not write after shutdown during the metadata read', async () => {
    let writes = 0;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { runtime.stop(); return { status: 'ready', metadata: {}, metadataVersion: 1 }; },
      compareAndSwap: async ({ metadata }) => { writes++; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    expect(await runtime.set({ expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } })).toMatchObject({ status: 'unavailable' });
    expect(writes).toBe(0);
  });
});

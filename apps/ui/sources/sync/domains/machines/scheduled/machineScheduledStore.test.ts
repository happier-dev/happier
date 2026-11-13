import { describe, expect, it } from 'vitest';
import { createMachineScheduledStore } from './machineScheduledStore';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { MachineScheduledResultV1 } from '@happier-dev/protocol/machines/scheduled/scheduledV1';

describe('Machine Scheduled shared consumption', () => {
  it('queues explicit refresh behind an active presented read', async () => {
    const initial = createDeferred<MachineScheduledResultV1>();
    const parked = createDeferred<MachineScheduledResultV1>();
    const refreshes: boolean[] = [];
    const store = createMachineScheduledStore(async (id, input) => {
      if (id === 'machines.scheduled.watch') return parked.promise;
      refreshes.push(input.refresh === true);
      return refreshes.length === 1 ? initial.promise : { kind: 'snapshot', revision: 2, sources: [], nextOffset: null };
    });
    const key = { serverId: 'h', machineId: 'm', pageSize: 1, accountId: 'a', credentialKey: 'k' };
    const release = store.subscribe(key, () => {});
    try {
      const firstRead = store.read(key);
      store.refresh(key);
      initial.resolve({ kind: 'snapshot', revision: 1, sources: [], nextOffset: null });
      await firstRead;
      expect(refreshes).toEqual([false, true]);
    } finally { release(); store.reset(); parked.resolve({ kind: 'unchanged' }); }
  });

  it('rearms a retired watch after explicit refresh', async () => {
    const failed = createDeferred<void>();
    const parked = createDeferred<MachineScheduledResultV1>();
    let watches = 0;
    let reads = 0;
    const store = createMachineScheduledStore(async id => {
      if (id === 'machines.scheduled.list') return { kind: 'snapshot', revision: ++reads, sources: [], nextOffset: null };
      if (++watches === 1) throw new Error('native transport unavailable');
      return parked.promise;
    });
    const key = { serverId: 'h', machineId: 'm', pageSize: 1, accountId: 'a', credentialKey: 'k' };
    const release = store.subscribe(key, () => { if (store.getState(key).status === 'error') failed.resolve(); });
    try {
      await failed.promise;
      await store.refresh(key);
      expect(watches).toBe(2);
    } finally { release(); store.reset(); parked.resolve({ kind: 'unchanged' }); }
  });

  it('requests a native rescan only for explicit refresh', async () => {
    const refreshes: boolean[] = [];
    const store = createMachineScheduledStore(async (_id, input) => {
      refreshes.push(input.refresh === true);
      return { kind: 'snapshot', revision: 1, sources: [], nextOffset: null };
    });
    const key = { serverId: 'h', machineId: 'm', pageSize: 1, accountId: 'a', credentialKey: 'k' };
    try {
      await store.read(key);
      await store.refresh(key);
      await store.read(key);
      expect(refreshes).toEqual([false, true, false]);
    } finally { store.reset(); }
  });

  it('shares a page read, applies a pushed page without rereading, and cancels after the last view leaves', async () => {
    const initial = createDeferred<MachineScheduledResultV1>();
    const push = createDeferred<MachineScheduledResultV1>();
    const pushed = createDeferred<void>();
    let reads = 0;
    let watchSignal: AbortSignal | undefined;
    const parked = createDeferred<MachineScheduledResultV1>();
    const store = createMachineScheduledStore(async (id, _input, signal) => {
      if (id === 'machines.scheduled.list') { reads++; return initial.promise; }
      watchSignal = signal;
      return store.getState(key).snapshot?.revision === 1 ? push.promise : parked.promise;
    });
    const key = { serverId: 'h', machineId: 'm', pageSize: 1, accountId: 'a', credentialKey: 'k' };
    const first = store.subscribe(key, () => { if (store.getState(key).snapshot?.revision === 2) pushed.resolve(); });
    const second = store.subscribe(key, () => {});
    initial.resolve({ kind: 'snapshot', revision: 1, sources: [], nextOffset: null });
    await initial.promise;
    push.resolve({ kind: 'snapshot', revision: 2, sources: [{ source: 'cron', kind: 'unavailable', reason: 'permission_denied' }], nextOffset: null });
    await pushed.promise;
    expect(reads).toBe(1);
    expect(store.getState(key).snapshot?.sources).toMatchObject([{ kind: 'unavailable', reason: 'permission_denied' }]);
    first(); second();
    expect(watchSignal?.aborted).toBe(true);
    store.reset(); parked.resolve({ kind: 'unchanged' });
  });
});

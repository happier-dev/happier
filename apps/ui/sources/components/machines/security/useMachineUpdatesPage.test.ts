import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useMachineUpdatesPage } from './useMachineUpdatesPage';

const baseline = storage.getState();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(baseline, true); });

it('reads just the visible page from pushed update facts without native checks, and retires hidden demand', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  const options = { sourceServerId: serverId };
  const rows = Array.from({ length: 120 }, (_, index) => createMachineFixture({ id: `updates-${index}`,
    daemonState: { status: 'running', setup: { version: 1, desiredRevision: 0, status: 'satisfied', recipes: [],
      updates: { status: 'drifted', backend: 'apt', pendingAll: index + 1, rebootNeeded: false } } },
  }));
  storage.getState().applyMachines(rows, true, options);
  const fetch = vi.spyOn(globalThis, 'fetch');
  const ids = rows.slice(0, 3).map(row => row.id);
  let renders = 0;
  const hook = await renderHook((enabled: boolean) => { renders++; return useMachineUpdatesPage({ serverId, machineIds: ids, enabled }); }, { initialProps: true });
  expect(hook.getCurrent().map(row => row.observation?.pendingAll)).toEqual([1, 2, 3]);
  const initial = hook.getCurrent();
  renders = 0;
  for (const row of rows.slice(3)) {
    await act(async () => storage.getState().applyMachines([{ ...row, daemonStateVersion: 2,
      daemonState: { ...row.daemonState, serviceLabel: 'unrelated' } }], false, options));
  }
  expect(renders).toBe(0);
  expect(hook.getCurrent()).toBe(initial);
  const current = storage.getState().machines[ids[0]!]!;
  await act(async () => storage.getState().applyMachines([{ ...current, daemonStateVersion: 3,
    daemonState: { ...current.daemonState, setup: { ...current.daemonState!.setup!,
      updates: { status: 'drifted', pendingAll: 9, rebootNeeded: true } } } }], false, options));
  expect(hook.getCurrent()[0]?.observation).toMatchObject({ pendingAll: 9, rebootNeeded: true });
  expect(hook.getCurrent()[1]).toBe(initial[1]);
  expect(fetch).not.toHaveBeenCalled();
  await hook.rerender(false);
  expect(hook.getCurrent()).toEqual([]);
});

it('withdraws locked facts and keeps absent update counts unknown', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  const row = createMachineFixture({ id: 'updates-locked' });
  storage.getState().applyMachines([row], true, { sourceServerId: serverId });
  const ids = [row.id, 'missing'];
  const hook = await renderHook(() => useMachineUpdatesPage({ serverId, machineIds: ids, enabled: true }));
  expect(hook.getCurrent().map(entry => entry.observation)).toEqual([null, null]);
  await act(async () => storage.getState().applyMachines([{ ...row, daemonStateVersion: 2,
    daemonState: { status: 'running', setup: { version: 1, desiredRevision: 0, status: 'satisfied', recipes: [],
      updates: { status: 'satisfied', pendingAll: 0 } } } }], false, { sourceServerId: serverId }));
  expect(hook.getCurrent()[0]?.observation?.pendingAll).toBe(0);
  await act(async () => storage.getState().applyMachines([{ ...storage.getState().machines[row.id]!,
    availability: { kind: 'locked', reason: 'content_unreadable' } }], false, { sourceServerId: serverId }));
  expect(hook.getCurrent()[0]?.observation).toBeNull();
});

it('performs update reads proportional to the requested Machines rather than the fleet', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  const rows = Array.from({ length: 120 }, (_, index) => createMachineFixture({ id: `cost-${index}` }));
  storage.getState().applyMachines(rows, true, { sourceServerId: serverId });
  const reads = rows.map(() => 0);
  const selected = [rows[2]!.id, rows[80]!.id];
  // Observe actual field access without replacing the internal read or subscription owner.
  for (const [index, row] of rows.entries()) {
    const stored = storage.getState().machines[row.id]!;
    const value = stored.daemonState;
    Object.defineProperty(stored, 'daemonState', { configurable: true, get: () => { reads[index]!++; return value; } });
  }
  const hook = await renderHook(() => useMachineUpdatesPage({ serverId, machineIds: selected, enabled: true }));
  expect(hook.getCurrent().map(entry => entry.machineId)).toEqual(selected);
  expect(reads[2]).toBeGreaterThan(0);
  expect(reads[80]).toBe(reads[2]);
  expect(reads.filter((_, index) => index !== 2 && index !== 80).reduce((sum, count) => sum + count, 0)).toBe(0);
});

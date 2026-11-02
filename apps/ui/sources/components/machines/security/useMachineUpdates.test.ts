import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useMachineUpdates } from './useMachineUpdates';

const baseline = storage.getState();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(baseline, true); });

it('keeps missing counts and reboot unknown, consumes pushed native facts, and stays quiet for unrelated Machine changes', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  const options = { sourceServerId: serverId };
  let machine = createMachineFixture({ daemonState: { status: 'running' } });
  storage.getState().applyMachines([machine], true, options);
  let renders = 0;
  const hook = await renderHook(() => { renders++; return useMachineUpdates({
    machineId: machine.id, serverId, enabled: true, reachable: false,
  }); });
  expect(hook.getCurrent()).toMatchObject({ status: 'unknown', pendingAll: null, pendingSecurity: null, rebootNeeded: null });
  renders = 0;
  for (let index = 0; index < 10; index++) {
    machine = { ...machine, activeAt: index + 20, daemonStateVersion: index + 2,
      daemonState: { ...machine.daemonState, serviceLabel: `service-${index}` } };
    await act(async () => storage.getState().applyMachines([machine], false, options));
  }
  expect(renders).toBe(0);
  machine = { ...machine, daemonStateVersion: 20, daemonState: { ...machine.daemonState,
    setup: { version: 1, desiredRevision: 0, status: 'unverifiable', recipes: [],
      updates: { status: 'drifted', backend: 'apt', pendingAll: 4, pendingSecurity: 2, rebootNeeded: true } } } };
  await act(async () => storage.getState().applyMachines([machine], false, options));
  expect(renders).toBe(1);
  expect(hook.getCurrent()).toMatchObject({ status: 'drifted', pendingAll: 4, pendingSecurity: 2, rebootNeeded: true });
  machine = { ...machine, daemonStateVersion: 21, daemonState: { ...machine.daemonState,
    setup: { ...machine.daemonState!.setup!, updates: { status: 'unavailable', reason: 'needs_admin_to_check', rebootNeeded: true } } } };
  await act(async () => storage.getState().applyMachines([machine], false, options));
  expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', pendingAll: null, pendingSecurity: null, rebootNeeded: true });
});

it('takes no subscriptions or network work while Security is closed', async () => {
  const subscribe = vi.spyOn(storage, 'subscribe');
  const fetch = vi.spyOn(globalThis, 'fetch');
  const hook = await renderHook(() => useMachineUpdates({ serverId: getActiveServerSnapshot().serverId,
    machineId: 'hidden-machine', enabled: false, reachable: true }));
  expect(hook.getCurrent()).toMatchObject({ status: 'unknown', rebootNeeded: null });
  expect(subscribe).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

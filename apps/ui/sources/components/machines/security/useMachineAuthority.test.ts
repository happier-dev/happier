import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useMachineAuthority } from './useMachineAuthority';
import type { MachineAdminAccessObservationV1 } from '@happier-dev/protocol/machines/adminAccessV1';

const observation: MachineAdminAccessObservationV1 = {
  version: 1, observedAt: 1, daemonUid: 1000, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
  rootEquivalentGroups: [], passwordlessSudoToRoot: 'denied', managedDropIn: 'absent',
  groupMembership: { state: 'current' },
  tailscaledOperator: { authorization: 'denied' },
};
const baseline = storage.getState();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(baseline, true); });

describe('useMachineAuthority', () => {
  it('does not upgrade retained authority after a Machine reconnects without fresh inspect provenance', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const held = { ...observation, tailscaledOperator: { authorization: 'allowed' as const } };
    const machine = createMachineFixture({ active: false, daemonState: { status: 'running', adminAccess: held } });
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const hook = await renderHook(() => useMachineAuthority({ machineId: machine.id }));
    const expected = { hostAuthority: 'unknown', lastKnownHostAuthority: 'ordinary', freshness: 'stale',
      tailscaledOperator: { authorization: 'allowed', currentAuthorization: 'unknown' } };
    expect(hook.getCurrent()).toMatchObject(expected);
    await act(async () => storage.getState().applyMachines([{ ...machine, active: true, activeAt: Date.now() }], false,
      { sourceServerId: serverId }));
    expect(hook.getCurrent()).toMatchObject(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('has zero subscriptions and requests while closed, and drops subscriptions on close', async () => {
    const machine = createMachineFixture({ daemonState: { status: 'running', adminAccess: observation } });
    storage.setState({ machines: { [machine.id]: machine } });
    const subscribe = vi.spyOn(storage, 'subscribe');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useMachineAuthority({
      machineId: machine.id, enabled, freshness: 'current',
    }), { initialProps: { enabled: false } });
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(hook.getCurrent().hostAuthority).toBe('unknown');
    await hook.rerender({ enabled: true });
    expect(hook.getCurrent().hostAuthority).toBe('ordinary');
    expect(fetch).not.toHaveBeenCalled();
    await hook.rerender({ enabled: false });
    let renders = 0;
    const closed = await renderHook(() => { renders++; return useMachineAuthority({ machineId: machine.id, enabled: false }); });
    renders = 0;
    for (let index = 0; index < 10; index++) await act(async () => storage.setState({ isDataReady: index % 2 === 0 }));
    expect(renders).toBe(0);
    expect(closed.getCurrent().hostAuthority).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the exact retained fields: unrelated same-Machine and fleet changes stay quiet; real authority changes arrive', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const options = { sourceServerId: serverId };
    const machines = Array.from({ length: 100 }, (_, index) => createMachineFixture({
      id: `machine-${index}`, daemonState: { status: 'running', adminAccess: observation, agentIsolation: { kind: 'disabled' } },
    }));
    storage.getState().applyMachines(machines, true, options);
    let renders = 0;
    const hook = await renderHook(() => { renders++; return useMachineAuthority({
      machineId: 'machine-0', freshness: 'current',
    }); });
    expect(hook.getCurrent().hostAuthority).toBe('ordinary');
    renders = 0;
    let first = machines[0]!;
    for (let index = 0; index < 10; index++) {
      first = { ...first, metadata: { ...first.metadata!, host: `renamed-${index}` },
        metadataVersion: index + 2,
        daemonState: { ...first.daemonState, serviceLabel: `service-${index}` }, daemonStateVersion: index + 2, activeAt: index + 20 };
      await act(async () => storage.getState().applyMachines([first, { ...machines[1]!, activeAt: index + 30 }], false, options));
    }
    expect(renders).toBe(0);
    const next = { ...observation, tailscaledOperator: { authorization: 'allowed' as const } };
    first = { ...first, daemonState: { ...first.daemonState, adminAccess: next }, daemonStateVersion: 20 };
    await act(async () => storage.getState().applyMachines([first], false, options));
    expect(renders).toBe(1);
    expect(hook.getCurrent()).toMatchObject({ hostAuthority: 'ordinary',
      tailscaledOperator: { currentAuthorization: 'allowed' } });
    first = { ...first, daemonState: { ...first.daemonState, adminAccess: { ...next,
      rootEquivalentGroups: ['docker'], groupMembership: { state: 'pendingRestart', addedGroups: ['docker'], removedGroups: [] } } },
      daemonStateVersion: 21 };
    await act(async () => storage.getState().applyMachines([first], false, options));
    expect(renders).toBe(2);
    expect(hook.getCurrent()).toMatchObject({ hostAuthority: 'administrator',
      groupMembership: { state: 'pendingRestart', addedGroups: ['docker'], removedGroups: [] } });
  });
});

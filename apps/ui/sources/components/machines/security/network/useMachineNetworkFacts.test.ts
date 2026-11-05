import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { recordMachineRequestSucceeded, recordMachineRequestFailed, clearMachineRequestReachabilityForScope,
  clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';
import { act } from 'react-test-renderer';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { MachineReachabilityObservationV1Schema, MachineReachabilityPostureV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';
import type { AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';

const observation = MachineReachabilityObservationV1Schema.parse({ revision: 0,
  management: { daemon: 'ready', publicSsh: 'unknown', providers: [] }, privateNetworks: [], ingress: [],
});
const posture = MachineReachabilityPostureV1Schema.parse({ revision: 0,
  management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' },
});
const baseline = storage.getState();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(baseline, true); clearMachineRequestReachabilityForTest(); });

function machine(id: string) {
  const base = createMachineFixture({ id, daemonState: { status: 'running', reachability: observation } });
  const accessProviderSelections: AccessProviderSelectionV1[] = [];
  return { ...base, metadata: { ...base.metadata!, reachabilityPosture: posture, accessProviderSelections } };
}

describe('M-P21E Network field hook preparation against the real publication owner', () => {
  it('reads only the bound Machine last answer, retains failure history, and releases the timestamp when closed', async () => {
    // This scoped owner test needs an explicit Home; a fresh app has no active Home.
    const serverId = 'network-answer-home';
    const row = machine('network-answer');
    storage.getState().applyMachines([row], true, { sourceServerId: serverId });
    const accountA = { serverId, accountId: 'account-a' };
    const accountB = { serverId, accountId: 'account-b' };
    let snapshots = 0;
    let renders = 0;
    // Observe React's real snapshot boundary; retain its subscription and snapshot semantics.
    const useSyncExternalStore = React.useSyncExternalStore;
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((subscribe, read, readServer) =>
      useSyncExternalStore(subscribe, () => { snapshots++; return read(); }, readServer));
    const hook = await renderHook(({ scope, enabled }: { scope: typeof accountA; enabled: boolean }) => {
      renders++;
      const input = { machineId: row.id, serverId, enabled, scope };
      return useMachineNetworkFacts(input);
    }, { initialProps: { scope: accountA, enabled: true } });
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', null);
    expect(hook.getCurrent()).toHaveProperty('access.ssh.state', 'unknown');
    const initial = hook.getCurrent();
    renders = 0; snapshots = 0;
    await act(async () => {
      for (let index = 0; index < 138; index++) recordMachineRequestSucceeded({ ...accountA, machineId: `unrelated-${index}`, observedAtMs: 10 });
      recordMachineRequestSucceeded({ ...accountB, machineId: row.id, observedAtMs: 20 });
      recordMachineRequestSucceeded({ ...accountA, machineId: row.id, route: 'loopback_direct', observedAtMs: 30 });
    });
    expect(snapshots).toBe(0);
    expect(renders).toBe(0);
    await act(async () => recordMachineRequestSucceeded({ ...accountA, machineId: row.id, observedAtMs: 40 }));
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', 40);
    expect(renders).toBe(1);
    expect(hook.getCurrent().posture).toBe(initial.posture);
    expect(hook.getCurrent().observation).toBe(initial.observation);
    expect(hook.getCurrent().access).toBe(initial.access);
    snapshots = 0;
    await act(async () => recordMachineRequestFailed({ ...accountA, machineId: row.id, observedAtMs: 50 }));
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', 40);
    expect(snapshots).toBe(0);
    await act(async () => recordMachineRequestSucceeded({ ...accountA, machineId: row.id, observedAtMs: 60 }));
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', 60);
    await hook.rerender({ scope: accountB, enabled: true });
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', 20);
    await act(async () => clearMachineRequestReachabilityForScope(accountB));
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', null);
    await hook.rerender({ scope: accountA, enabled: false });
    snapshots = 0; renders = 0;
    await act(async () => recordMachineRequestSucceeded({ ...accountA, machineId: row.id, observedAtMs: 70 }));
    expect(hook.getCurrent()).toHaveProperty('lastAnsweredAtMs', null);
    expect(snapshots).toBe(0);
    expect(renders).toBe(0);
  });
  it('subscribes and reads nothing while closed, then releases on close', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const row = machine('network-hook-a');
    storage.getState().applyMachines([row], true, { sourceServerId: serverId });
    const subscribe = vi.spyOn(storage, 'subscribe');
    const fetch = vi.spyOn(globalThis, 'fetch');
    let renders = 0;
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
      renders++;
      return useMachineNetworkFacts({ machineId: row.id, serverId, enabled });
    }, { initialProps: { enabled: false } });
    expect(subscribe).not.toHaveBeenCalled();
    expect(hook.getCurrent()).toEqual({ posture: null, selections: null, observation: null, access: null });
    await hook.rerender({ enabled: true });
    expect(hook.getCurrent().observation).toEqual(observation);
    await hook.rerender({ enabled: false });
    renders = 0;
    await act(async () => storage.getState().applyMachines([{ ...row, daemonStateVersion: 2,
      daemonState: { ...row.daemonState, reachability: { ...observation, revision: 1, management: {
        ...observation.management, daemon: 'unavailable' as const,
      } } },
    }], false, { sourceServerId: serverId }));
    expect(renders).toBe(0);
    await hook.rerender({ enabled: true });
    expect(hook.getCurrent().observation?.management.daemon).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps unaffected Network consumers quiet at 125 Machines and delivers a real observation change', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const options = { sourceServerId: serverId };
    const rows = Array.from({ length: 125 }, (_, index) => machine(`network-${index}`));
    const retainedNetwork = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: {}, credentialRefs: [] };
    rows[0] = { ...rows[0]!, metadata: { ...rows[0]!.metadata,
      accessProviderSelections: [{ ...retainedNetwork, provider: { kind: 'builtin', id: 'caddy' } }, retainedNetwork] } };
    storage.getState().applyMachines(rows, true, options);
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return useMachineNetworkFacts({ machineId: 'network-0', serverId, enabled: true });
    });
    const initial = hook.getCurrent();
    expect(initial.access?.joinablePrivateNetworkSelections).toEqual([retainedNetwork]);
    let first = rows[0]!;
    renders = 0;
    for (let index = 0; index < 10; index++) {
      first = { ...first, metadata: { ...first.metadata, host: `renamed-${index}` }, metadataVersion: index + 2,
        daemonState: { ...first.daemonState, serviceLabel: `service-${index}` }, daemonStateVersion: index + 2,
        activeAt: index + 20 };
      await act(async () => storage.getState().applyMachines([first, { ...rows[1]!, activeAt: index + 30 }], false, options));
    }
    expect(renders).toBe(0);
    expect(hook.getCurrent().observation).toBe(initial.observation);
    expect(hook.getCurrent().posture).toBe(initial.posture);
    expect(hook.getCurrent().access).toBe(initial.access);
    const changed = MachineReachabilityObservationV1Schema.parse({ ...observation, revision: 1,
      management: { ...observation.management, publicSsh: 'open' },
    });
    await act(async () => storage.getState().applyMachines([{ ...first, daemonStateVersion: 20,
      daemonState: { ...first.daemonState, reachability: changed },
    }], false, options));
    expect(renders).toBe(1);
    expect(hook.getCurrent().observation?.management.publicSsh).toBe('open');
    expect(hook.getCurrent()).toHaveProperty('access.ssh.state', 'open');
    expect(hook.getCurrent().access).not.toBe(initial.access);
    expect(hook.getCurrent().posture).toBe(initial.posture);
    expect(hook.getCurrent().selections).toBe(initial.selections);
  });

  it('withdraws retained facts on revocation at the canonical Machine ingestion boundary', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const row = machine('network-withdraw');
    storage.getState().applyMachines([row], true, { sourceServerId: serverId });
    const hook = await renderHook(() => useMachineNetworkFacts({ machineId: row.id, serverId, enabled: true }));
    expect(hook.getCurrent().observation).not.toBeNull();
    await act(async () => storage.getState().applyMachines([{ ...row, revokedAt: 1 }], false, { sourceServerId: serverId }));
    expect(hook.getCurrent()).toEqual({ posture: null, selections: null, observation: null, access: null });
    await act(async () => storage.getState().applyMachines([{ ...row, metadataVersion: 3, daemonStateVersion: 3,
      daemonState: { ...row.daemonState, reachability: { ...observation, revision: 2,
        management: { ...observation.management, publicSsh: 'open' as const },
      } },
    }], false, { sourceServerId: serverId }));
    expect(hook.getCurrent().observation?.management.publicSsh).toBe('open');
  });
});

import { describe, expect, it } from 'vitest';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { TrackedSession } from '@/daemon/types';
import { createTrackedRunnerAgentRegistryAccess } from './trackedRunnerAgentRegistryAccess';

// The daemon's plugin runtime controller is the lease boundary: each acquisition is counted.
function leaseSource() {
  const binding = { pluginId: 'p', localAgentId: 'codex' } as never;
  const registry = {
    agentRuntimesByAgentId: new Map([['codex', { hasPrimaryRuntime: true, sessionRunnerFactoryBinding: binding, isCurrent: () => true }]]),
    reserveManagedDependencyRetention: () => ({ retention: { v: 1, sourceCustodies: [], qualifiedDependencyIds: [] }, release() {} }),
  } as unknown as PluginRuntimeRegistryLease['registry'];
  let acquired = 0;
  let released = 0;
  return {
    registry, binding,
    counts: () => ({ acquired, released }),
    acquireLease: async () => {
      acquired += 1;
      return { registry, source: 'active', durableRevision: 1, release: async () => { released += 1; } } as unknown as PluginRuntimeRegistryLease;
    },
  };
}

describe('tracked runner Agent registry access', () => {
  it('takes one registry lease per spawn: a just-spawned Session reads its spawn\'s held registry, a reattached one leases once', async () => {
    const spawned = leaseSource();
    const fresh = createTrackedRunnerAgentRegistryAccess({
      tracked: { trackingKey: 'k', readSpawnPluginRuntimeRegistry: () => spawned.registry } as unknown as TrackedSession,
      acquireLease: spawned.acquireLease,
    });
    expect(await fresh.resolveCurrentRetainedAgent({ agentId: 'codex' })).toBe(spawned.binding);
    await fresh.reserveManagedDependencyRetention(spawned.binding);
    await fresh.release();
    expect(spawned.counts()).toEqual({ acquired: 0, released: 0 });

    const reattached = leaseSource();
    const adopted = createTrackedRunnerAgentRegistryAccess({
      tracked: { trackingKey: 'k' } as unknown as TrackedSession,
      acquireLease: reattached.acquireLease,
    });
    await adopted.resolveCurrentRetainedAgent({ agentId: 'codex' });
    await adopted.reserveManagedDependencyRetention(reattached.binding);
    await adopted.release();
    expect(reattached.counts()).toEqual({ acquired: 1, released: 1 });
  });
});

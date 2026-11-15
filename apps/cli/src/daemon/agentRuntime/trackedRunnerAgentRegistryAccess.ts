import type { AgentSessionRunnerBindingV1 } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { TrackedSession } from '@/daemon/types';

type Registry = PluginRuntimeRegistryLease['registry'];

/**
 * The plugin runtime registry a tracked runner's authority reconciliation reads: the retained
 * Agent binding and its managed-dependency reservation. A Session its spawn just launched reads the
 * registry that spawn still holds (one lease per spawn); a reattached or later reconciliation takes
 * one lease for both reads and releases it with `release()`. Currentness stays a live check
 * (`registration.isCurrent()`), whichever lease serves the read.
 */
export function createTrackedRunnerAgentRegistryAccess(input: Readonly<{
  tracked: TrackedSession;
  acquireLease: () => Promise<PluginRuntimeRegistryLease>;
}>) {
  let lease: Promise<PluginRuntimeRegistryLease> | null = null;
  const withRegistry = async <T>(use: (registry: Registry) => T | Promise<T>): Promise<T> => {
    const held = input.tracked.readSpawnPluginRuntimeRegistry?.();
    return await use(held ?? (await (lease ??= input.acquireLease())).registry);
  };
  return {
    resolveCurrentRetainedAgent: async ({ agentId }: Readonly<{ agentId: string }>): Promise<AgentSessionRunnerBindingV1> =>
      await withRegistry((registry) => {
        const registration = registry.agentRuntimesByAgentId.get(agentId);
        if (
          !registration
          || !registration.hasPrimaryRuntime
          || !registration.sessionRunnerFactoryBinding
          || registration.isCurrent() !== true
        ) {
          throw new Error(`Runner Agent '${agentId}' has no current retained binding`);
        }
        return registration.sessionRunnerFactoryBinding;
      }),
    reserveManagedDependencyRetention: async (retainedAgent: AgentSessionRunnerBindingV1) =>
      await withRegistry((registry) => registry.reserveManagedDependencyRetention?.(retainedAgent) ?? {
        retention: { v: 1 as const, sourceCustodies: [], qualifiedDependencyIds: [] },
        release() {},
      }),
    release: async (): Promise<void> => {
      const owned = lease;
      lease = null;
      if (owned) await (await owned).release();
    },
  };
}

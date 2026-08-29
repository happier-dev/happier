import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

/**
 * The one active-first reader for the current contribution registry.
 *
 * The built-in snapshot from `getResolvedContributionRegistry()` is immutable
 * and never reflects an installed plugin or a reload. The plugin reload
 * controller's active registry is the merged built-in + external projection,
 * so it answers first whenever it is current; otherwise this falls back to the
 * built-in snapshot. Readers must not reach into either source directly: the
 * cold snapshot alone makes an externally contributed contribution invisible,
 * and a retained active registry can outlive its generation.
 */
export function readCurrentContributionRegistry(): ResolvedContributionRegistry {
  const activeRegistry = pluginReloadController.getState().activeRegistry;
  if (activeRegistry && pluginReloadController.isRuntimeRegistryCurrent(activeRegistry)) {
    return activeRegistry.contributes;
  }
  return getResolvedContributionRegistry();
}

/**
 * Canonical reader for "which Agents are installed right now".
 *
 * `executionRunProfiles` travels with the same projection because the profile
 * that declares an Agent a review engine is contributed by the same plugin as
 * the Agent, and splitting the two readers would let an installed Agent and its
 * profiles come from different registry generations.
 */
export function readAgentCatalogSnapshot(): Pick<
  ResolvedContributionRegistry,
  'agentDefinitionsById' | 'catalogEntriesById' | 'executionRunProfiles'
> {
  return readCurrentContributionRegistry();
}

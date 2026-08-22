import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

/**
 * Canonical reader for "which Agents are installed right now".
 *
 * The module-level `getResolvedContributionRegistry()` cache holds whatever was
 * last primed — built-ins only until a prime runs, and never a plugin reload
 * that happened afterwards. The plugin reload controller's active registry is
 * the merged built-in + external projection, so it answers first whenever it is
 * current. Reading the cold cache directly makes an externally contributed
 * Agent invisible; every Agent-catalog reader goes through here.
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
  const activeRegistry = pluginReloadController.getState().activeRegistry;
  if (activeRegistry && pluginReloadController.isRuntimeRegistryCurrent(activeRegistry)) {
    return activeRegistry.contributes;
  }
  return getResolvedContributionRegistry();
}

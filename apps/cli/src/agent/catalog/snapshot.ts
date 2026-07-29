import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

export function readAgentCatalogSnapshot(): Pick<
  ResolvedContributionRegistry,
  'agentDefinitionsById' | 'catalogEntriesById'
> {
  const activeRegistry = pluginReloadController.getState().activeRegistry;
  if (activeRegistry && pluginReloadController.isRuntimeRegistryCurrent(activeRegistry)) {
    return activeRegistry.contributes;
  }
  return getResolvedContributionRegistry();
}

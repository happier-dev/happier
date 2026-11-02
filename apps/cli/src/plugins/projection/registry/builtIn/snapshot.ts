import type { AgentCatalogEntry, CatalogAgentId } from '@/agent/catalog/types';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../resolveBuiltInContributions';
import type { ResolvedContributionRegistry, ResolvedPluginEnablement, UnavailableAgentPlugin } from '../types';
import { resolveBundledPluginEnablement } from './enablement';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '../sources/generatedBundledPluginManifests';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';

/** Read desired scope facts once for this admission, never from its consumers. */
export async function readCurrentBundledPluginEnablement(params?: Readonly<{
  happyHomeDir?: string;
  machineEnabledById?: Readonly<Record<string, boolean>>;
  accountStorageDependencies?: Pick<AccountPluginDataStorageHostDependencies, 'readCredentials' | 'resolveBaseUrl'>;
}>): Promise<Readonly<Record<string, ResolvedPluginEnablement>>> {
  const machineEnabledById = params?.machineEnabledById ?? (await (
    await import('@/plugins/store/registry/currentState')
  ).createPluginRegistryStateStore({ happyHomeDir: params?.happyHomeDir }).readSnapshot()).bundledPluginEnabledById;
  const pluginIds = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map(plugin => plugin.pluginId);
  let accountEnabledById: ReadonlyMap<string, boolean> | undefined;
  let accountUnavailable: true | undefined;
  try {
    const { readStoredCredentials } = await import('@/persistence');
    const credentials = await (params?.accountStorageDependencies?.readCredentials ?? readStoredCredentials)();
    if (credentials) {
      const { resolveServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
      const { readCurrentAccountPluginEnablements } = await import('@/plugins/runtime/accountPluginActivationSource');
      accountEnabledById = await readCurrentAccountPluginEnablements({ credentials,
        serverUrl: params?.accountStorageDependencies?.resolveBaseUrl?.() ?? resolveServerHttpBaseUrl(), pluginIds });
    }
  } catch {
    // Optional plugin reachability cannot stop the host. A failed Account read
    // withdraws new admission with its existing typed refusal, never as "on".
    accountUnavailable = true;
  }
  return resolveBundledPluginEnablement({ pluginIds, accountEnabledById, machineEnabledById, accountUnavailable });
}

/**
 * The sole immutable built-in snapshot. Import this owner only when the full
 * snapshot is needed; exact selections use the canonical projection directly.
 * Semantic admission settles before synchronous readers can see the snapshot.
 * Installed plugins and reloads never replace this built-in authority.
 */
let builtInResolvedContributionRegistry: ResolvedContributionRegistry | null = null;

export function getResolvedContributionRegistry(params?: Readonly<{
  pluginEnablementById: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ResolvedContributionRegistry {
  builtInResolvedContributionRegistry ??= Object.freeze(
    createResolvedContributionRegistry(resolveBuiltInContributions()),
  );
  if (!params) return builtInResolvedContributionRegistry;
  const unavailableAgentPluginsByBackendId: Record<string, UnavailableAgentPlugin> = {};
  for (const agent of builtInResolvedContributionRegistry.agents) {
    const fact = agent.pluginId ? params.pluginEnablementById[agent.pluginId] : undefined;
    if (!fact || fact.enabled || !agent.pluginId) continue;
    const unavailable = Object.freeze({ ...fact, pluginId: agent.pluginId, code: fact.unavailableCode ?? 'plugin_disabled' as const });
    for (const backendId of new Set([agent.id, ...(agent.definition.ownedBackendIds ?? [])])) {
      unavailableAgentPluginsByBackendId[backendId] = unavailable;
    }
  }
  const declarations = Object.values(params.pluginEnablementById).some(fact => !fact.enabled)
    ? createResolvedContributionRegistry(resolveBuiltInContributions(params)) : builtInResolvedContributionRegistry;
  return Object.freeze({ ...declarations, pluginEnablementById: params.pluginEnablementById,
    unavailableAgentPluginsByBackendId: Object.freeze(unavailableAgentPluginsByBackendId) });
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
  return getResolvedContributionRegistry().catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}

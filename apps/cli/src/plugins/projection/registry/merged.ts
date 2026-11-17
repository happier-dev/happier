import type { createMergedContributionRegistry, createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import { resolveSelectedBuiltInContributions } from './selected';
import type { ResolvedContributionRegistry } from './types';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';

/** One standalone registry owner; selections reuse admission and replacement semantics. */
export async function resolveMergedContributionRegistry(
  params?: Readonly<{ happyHomeDir?: string; pluginIds?: readonly string[]; providerContributionKeys?: readonly string[]; agentIdentity?: PluginContributionIdentityV1;
    accountStorageDependencies?: Pick<AccountPluginDataStorageHostDependencies, 'readCredentials' | 'resolveBaseUrl'>;
  }>,
): Promise<ResolvedContributionRegistry> {
  const { createMergedContributionRegistry, createResolvedContributionRegistry } = await import('./createResolvedContributionRegistry');
  const selection = params?.agentIdentity ? { agentIdentity: params.agentIdentity, providerContributionKeys: params.providerContributionKeys }
    : params?.providerContributionKeys ? { providerContributionKeys: params.providerContributionKeys } : undefined;
  const { getResolvedContributionRegistry, readCurrentBundledPluginEnablement } = await import('./builtIn/snapshot');
  const pluginEnablementById = await readCurrentBundledPluginEnablement({ happyHomeDir: params?.happyHomeDir,
    accountStorageDependencies: params?.accountStorageDependencies });
  const builtIn = selection
    ? createResolvedContributionRegistry(resolveSelectedBuiltInContributions({ ...selection, pluginEnablementById }))
    : params?.pluginIds !== undefined
    ? createResolvedContributionRegistry({
        ...resolveBuiltInContributions({ pluginIds: params.pluginIds, pluginEnablementById }),
        pluginEnablementById,
      })
    : getResolvedContributionRegistry({ pluginEnablementById });
  const { resolvePluginContributes } = await import('./resolvePluginContributions');
  const plugin = await resolvePluginContributes({
    happyHomeDir: params?.happyHomeDir,
    pluginIds: params?.pluginIds,
    providerContributionKeys: params?.providerContributionKeys,
    agentIdentity: params?.agentIdentity,
    pluginEnablementById,
    ...(!selection && params?.pluginIds === undefined ? { referenceGraph: { loadedPlugins: builtIn.pluginDeclarations ?? [],
      diagnosticsByPluginId: builtIn.pluginDiagnosticsByPluginId } } : {}),
    existingAgentIds: new Set(builtIn.agents.map(agent => agent.id)),
  });
  return createMergedContributionRegistry(plugin, builtIn);
}

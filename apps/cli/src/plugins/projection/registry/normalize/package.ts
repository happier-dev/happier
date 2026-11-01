import { projectPluginContributionRegistry, type PluginContributionRegistry } from './registry';
export type {
  PluginOwnedContribution, PluginOwnedSemanticContribution, PluginOwnedLocaleContribution,
  PluginOwnedUiRendererContribution, PluginOwnedClientExecutableContribution,
  PluginOwnedVoiceProviderContribution, PluginOwnedActionContribution, PluginOwnedContributionPoint,
  PluginOwnedAccountCollectionContribution, PluginOwnedOpenableContentViewerContribution,
  PluginOwnedComposerReferenceContribution, PluginOwnedComposerAttachmentContribution,
  PluginOwnedComposerControlContribution, PluginOwnedComposerRegionContribution, PluginContributionRegistry,
} from './registry';

/** Full semantic admission stays synchronous and completes before publication. */
export function buildPluginContributionRegistry(
  params: Omit<Parameters<typeof projectPluginContributionRegistry>[0], 'canonicalize'>,
): PluginContributionRegistry {
  return projectPluginContributionRegistry({ ...params,
    canonicalize: (entry, value, pluginId) => entry.canonicalize(value, { pluginId }),
  });
}

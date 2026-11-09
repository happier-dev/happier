import { normalizePluginWorkflowContributionV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceV1';
import { projectPluginContributionRegistry, type PluginContributionRegistry } from './registry';
export type {
  PluginOwnedContribution, PluginOwnedSemanticContribution, PluginOwnedLocaleContribution,
  PluginOwnedUiRendererContribution, PluginOwnedClientExecutableContribution,
  PluginOwnedVoiceProviderContribution, PluginOwnedActionContribution, PluginOwnedContributionPoint,
  PluginOwnedAccountCollectionContribution, PluginOwnedOpenableContentViewerContribution,
  PluginOwnedComposerReferenceContribution, PluginOwnedComposerAttachmentContribution,
  PluginOwnedComposerControlContribution, PluginOwnedComposerRegionContribution, PluginContributionRegistry,
} from './registry';

/** Contextual Workflow normalization follows the manifest's structural admission. */
export function buildPluginContributionRegistry(
  params: Omit<Parameters<typeof projectPluginContributionRegistry>[0], 'canonicalize'>,
): PluginContributionRegistry {
  return projectPluginContributionRegistry({ ...params,
    canonicalize: (entry, value, pluginId) => entry.manifestKey === 'workflows'
      ? normalizePluginWorkflowContributionV1(value, pluginId)
      : value,
  });
}

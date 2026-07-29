import type { PromptAssetAdapter } from './types';
import type { PluginPromptAssetAdapterDescriptor } from './pluginPromptAssetAdapterDescriptor';
import { createAgentsSkillPromptAssetAdapter } from './adapters/agentsSkill/createAgentsSkillPromptAssetAdapter';
import { createSkillMdPromptAssetAdapter } from './adapters/skillMd/createSkillMdPromptAssetAdapter';
import { createMarkdownDocPromptAssetAdapter } from './adapters/markdownDoc/createMarkdownDocPromptAssetAdapter';
import { BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS } from './generated/pluginDescriptors';

function createPluginPromptAssetAdapter(
  descriptor: PluginPromptAssetAdapterDescriptor,
  params?: Readonly<{
    homedir?: () => string;
    happierHomeDir?: () => string;
  }>,
): PromptAssetAdapter {
  switch (descriptor.adapterKind) {
    case 'markdownDoc':
      return createMarkdownDocPromptAssetAdapter(descriptor, {
        homedir: params?.homedir,
      });
    case 'skillMd':
      return createSkillMdPromptAssetAdapter(descriptor, {
        homedir: params?.homedir,
        happierHomeDir: params?.happierHomeDir,
      });
  }
}

export function createPromptAssetAdapterRegistry(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): Map<string, PromptAssetAdapter> {
  const adapters = [
    createAgentsSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
    ...BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS.map((descriptor) =>
      createPluginPromptAssetAdapter(descriptor, params),
    ),
  ];

  return new Map(adapters.map((adapter) => [adapter.descriptor.id, adapter] as const));
}

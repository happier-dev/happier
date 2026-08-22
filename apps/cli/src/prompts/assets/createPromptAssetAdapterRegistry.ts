import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
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
  readRegisteredAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
}>): ReadonlyMap<string, PromptAssetAdapter> {
  const adapters = [
    createAgentsSkillPromptAssetAdapter({
      homedir: params?.homedir,
      happierHomeDir: params?.happierHomeDir,
    }),
    ...BUNDLED_FIRST_PARTY_PLUGIN_PROMPT_ASSET_DESCRIPTORS.map((descriptor) =>
      createPluginPromptAssetAdapter(descriptor, params),
    ),
  ];

  const builtInAdapters = new Map(adapters.map((adapter) => [adapter.descriptor.id, adapter] as const));
  const readRegisteredAdapters = params?.readRegisteredAdapters;
  if (!readRegisteredAdapters) return builtInAdapters;

  const readSnapshot = (): ReadonlyMap<string, PromptAssetAdapter> => {
    const snapshot = new Map(builtInAdapters);
    for (const [assetTypeId, adapter] of readRegisteredAdapters()) {
      if (assetTypeId !== adapter.descriptor.id) {
        throw new Error(`Prompt Asset adapter registry key '${assetTypeId}' does not match its descriptor id`);
      }
      if (snapshot.has(assetTypeId)) {
        throw new Error(`Duplicate Prompt Asset adapter type '${assetTypeId}'`);
      }
      snapshot.set(assetTypeId, adapter);
    }
    return snapshot;
  };
  let registryView: ReadonlyMap<string, PromptAssetAdapter>;
  registryView = Object.freeze({
    get size() { return readSnapshot().size; },
    get: (assetTypeId: string) => readSnapshot().get(assetTypeId),
    has: (assetTypeId: string) => readSnapshot().has(assetTypeId),
    entries: () => readSnapshot().entries(),
    keys: () => readSnapshot().keys(),
    values: () => readSnapshot().values(),
    [Symbol.iterator]: () => readSnapshot()[Symbol.iterator](),
    forEach(
      callback: (value: PromptAssetAdapter, key: string, map: ReadonlyMap<string, PromptAssetAdapter>) => void,
      thisArg?: unknown,
    ) {
      for (const [assetTypeId, adapter] of readSnapshot()) {
        callback.call(thisArg, adapter, assetTypeId, registryView);
      }
    },
  });
  return registryView;
}

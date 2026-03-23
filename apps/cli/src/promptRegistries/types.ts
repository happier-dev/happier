import type {
  PromptRegistryAdapterDescriptorV1,
  PromptRegistryConfiguredSourceV1,
  PromptRegistryFetchItemResponseV1,
  PromptRegistryItemSummaryV1,
  PromptRegistrySourceDescriptorV1,
} from '@happier-dev/protocol';

export type PromptRegistryResolvedSource = Readonly<{
  descriptor: PromptRegistrySourceDescriptorV1;
  config: Record<string, unknown>;
}>;

export type PromptRegistryAdapter = Readonly<{
  descriptor: PromptRegistryAdapterDescriptorV1;
  listBuiltInSources: () => Promise<PromptRegistryResolvedSource[]>;
  resolveConfiguredSource: (source: PromptRegistryConfiguredSourceV1) => PromptRegistryResolvedSource | null;
  scanSource: (args: Readonly<{
    source: PromptRegistryResolvedSource;
    query?: string | null;
  }>) => Promise<PromptRegistryItemSummaryV1[]>;
  fetchItem: (args: Readonly<{
    source: PromptRegistryResolvedSource;
    itemId: string;
  }>) => Promise<PromptRegistryFetchItemResponseV1>;
}>;

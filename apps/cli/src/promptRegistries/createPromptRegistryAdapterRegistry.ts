import type {
  PromptRegistryConfiguredSourceV1,
  PromptRegistryFetchItemResponseV1,
  PromptRegistryItemSummaryV1,
} from '@happier-dev/protocol';

import { createClaudeMarketplacePromptRegistryAdapter } from '@/promptRegistries/adapters/claudeMarketplace/createClaudeMarketplacePromptRegistryAdapter';
import { createGitPromptRegistryAdapter } from '@/promptRegistries/adapters/git/createGitPromptRegistryAdapter';
import { createSkillsShPromptRegistryAdapter } from '@/promptRegistries/adapters/skillsSh/createSkillsShPromptRegistryAdapter';
import type { PromptRegistryAdapter, PromptRegistryResolvedSource } from '@/promptRegistries/types';

export type PromptRegistryRegistry = Readonly<{
  adapters: Map<string, PromptRegistryAdapter>;
  listSources: (configuredSources: readonly PromptRegistryConfiguredSourceV1[]) => Promise<PromptRegistryResolvedSource[]>;
  scanSource: (args: Readonly<{
    sourceId: string;
    configuredSources: readonly PromptRegistryConfiguredSourceV1[];
    query?: string | null;
  }>) => Promise<PromptRegistryItemSummaryV1[]>;
  fetchItem: (args: Readonly<{
    sourceId: string;
    itemId: string;
    configuredSources: readonly PromptRegistryConfiguredSourceV1[];
  }>) => Promise<PromptRegistryFetchItemResponseV1>;
}>;

async function resolveAllSources(
  adapters: Iterable<PromptRegistryAdapter>,
  configuredSources: readonly PromptRegistryConfiguredSourceV1[],
): Promise<PromptRegistryResolvedSource[]> {
  const adapterList = [...adapters];
  const builtIn = await Promise.all(adapterList.map((adapter) => adapter.listBuiltInSources()));
  const configured = configuredSources.flatMap((source) => {
    const adapter = adapterList.find((entry) => entry.descriptor.id === source.adapterId);
    if (!adapter) return [];
    const resolved = adapter.resolveConfiguredSource(source);
    return resolved ? [resolved] : [];
  });
  return [...builtIn.flat(), ...configured];
}

export function createPromptRegistryAdapterRegistry(): PromptRegistryRegistry {
  const adapters = new Map<string, PromptRegistryAdapter>([
    ['claude_marketplace', createClaudeMarketplacePromptRegistryAdapter()],
    ['git', createGitPromptRegistryAdapter()],
    ['skills_sh', createSkillsShPromptRegistryAdapter()],
  ]);

  return {
    adapters,

    async listSources(configuredSources) {
      return await resolveAllSources(adapters.values(), configuredSources);
    },

    async scanSource(args) {
      const sources = await resolveAllSources(adapters.values(), args.configuredSources);
      const source = sources.find((entry) => entry.descriptor.id === args.sourceId) ?? null;
      if (!source) return [];
      const adapter = adapters.get(source.descriptor.adapterId);
      if (!adapter) return [];
      return await adapter.scanSource({
        source,
        query: args.query ?? null,
      });
    },

    async fetchItem(args) {
      const sources = await resolveAllSources(adapters.values(), args.configuredSources);
      const source = sources.find((entry) => entry.descriptor.id === args.sourceId) ?? null;
      if (!source) {
        return {
          ok: false,
          errorCode: 'not_found',
          error: 'registry source not found',
        };
      }
      const adapter = adapters.get(source.descriptor.adapterId);
      if (!adapter) {
        return {
          ok: false,
          errorCode: 'unsupported',
          error: 'registry adapter not found',
        };
      }
      return await adapter.fetchItem({
        source,
        itemId: args.itemId,
      });
    },
  };
}

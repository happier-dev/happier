import type { PromptRegistryConfiguredSourceV1 } from '@happier-dev/protocol';

import type { PromptRegistryAdapter } from '@/promptRegistries/types';
import { fetchGitPromptRegistryItem, scanGitPromptRegistrySource } from '@/promptRegistries/shared/gitPromptRegistrySource';

function readRepositoryUrl(source: PromptRegistryConfiguredSourceV1): string | null {
  const repositoryUrl = typeof source.config?.repositoryUrl === 'string' ? source.config.repositoryUrl.trim() : '';
  return repositoryUrl || null;
}

export function createGitPromptRegistryAdapter(): PromptRegistryAdapter {
  return {
    descriptor: {
      id: 'git',
      title: 'Git repositories',
      description: 'Scan SKILL.md bundles from Git repositories.',
      supportsConfiguredSources: true,
      supportsQuery: true,
    },

    async listBuiltInSources() {
      return [];
    },

    resolveConfiguredSource(source) {
      if (source.adapterId !== 'git' || source.enabled === false) return null;
      const repositoryUrl = readRepositoryUrl(source);
      if (!repositoryUrl) return null;

      return {
        descriptor: {
          id: `git:${source.id}`,
          adapterId: 'git',
          title: source.title,
          subtitle: repositoryUrl,
          origin: 'user',
        },
        config: {
          repositoryUrl,
          subdirectory: typeof source.config?.subdirectory === 'string' ? source.config.subdirectory.trim() : undefined,
        },
      };
    },

    async scanSource(args) {
      return await scanGitPromptRegistrySource({
        sourceId: args.source.descriptor.id,
        repositoryUrl: String(args.source.config.repositoryUrl),
        subdirectory: typeof args.source.config.subdirectory === 'string' ? args.source.config.subdirectory : null,
        query: args.query ?? null,
      });
    },

    async fetchItem(args) {
      return await fetchGitPromptRegistryItem({
        sourceId: args.source.descriptor.id,
        itemId: args.itemId,
        repositoryUrl: String(args.source.config.repositoryUrl),
        subdirectory: typeof args.source.config.subdirectory === 'string' ? args.source.config.subdirectory : null,
      });
    },
  };
}

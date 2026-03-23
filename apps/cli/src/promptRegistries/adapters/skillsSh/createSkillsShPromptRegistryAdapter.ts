import type { PromptRegistryAdapter } from '@/promptRegistries/types';
import { fetchSkillsShPromptRegistryItem } from './fetchSkillsShPromptRegistryItem';
import { scanSkillsShPromptRegistrySource } from './scanSkillsShPromptRegistrySource';

export function createSkillsShPromptRegistryAdapter(): PromptRegistryAdapter {
  return {
    descriptor: {
      id: 'skills_sh',
      title: 'skills.sh',
      description: 'Curated skills registry backed by the Vercel skills ecosystem.',
      supportsConfiguredSources: false,
      supportsQuery: true,
      minimumQueryLength: 2,
    },

    async listBuiltInSources() {
      return [{
        descriptor: {
          id: 'skills_sh:featured',
          adapterId: 'skills_sh',
          title: 'skills.sh',
          subtitle: 'Top skills from the public skills registry',
          origin: 'built_in',
        },
        config: {},
      }];
    },

    resolveConfiguredSource() {
      return null;
    },

    async scanSource(args) {
      return await scanSkillsShPromptRegistrySource({
        sourceId: args.source.descriptor.id,
        query: args.query ?? null,
      });
    },

    async fetchItem(args) {
      return await fetchSkillsShPromptRegistryItem({
        sourceId: args.source.descriptor.id,
        itemId: args.itemId,
      });
    },
  };
}

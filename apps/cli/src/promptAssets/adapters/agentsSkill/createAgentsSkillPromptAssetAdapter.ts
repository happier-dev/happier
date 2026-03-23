import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createSkillMdPromptAssetAdapter } from '@/promptAssets/adapters/skillMd/createSkillMdPromptAssetAdapter';

export function createAgentsSkillPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): PromptAssetAdapter {
  return createSkillMdPromptAssetAdapter({
    assetTypeId: 'agents.skill',
    providerId: 'agents',
    title: 'Agent skills (.agents)',
    description: 'Portable SKILL.md bundles discovered from .agents/skills.',
    projectRootPath: ['.agents', 'skills'],
    projectRootDisplayPath: '.agents/skills',
    userRootPath: ['.agents', 'skills'],
    userRootDisplayPath: '~/.agents/skills',
    capabilities: {
      supportsCatalogInstall: true,
      supportsSymlinkInstall: true,
    },
  }, params);
}

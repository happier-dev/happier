import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createSkillMdPromptAssetAdapter } from '@/promptAssets/adapters/skillMd/createSkillMdPromptAssetAdapter';

export function createCopilotSkillPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): PromptAssetAdapter {
  return createSkillMdPromptAssetAdapter({
    assetTypeId: 'copilot.skill',
    providerId: 'copilot',
    title: 'Copilot skills (.github/.copilot)',
    description: 'SKILL.md bundles discovered from GitHub Copilot skill folders.',
    projectRootPath: ['.github', 'skills'],
    projectRootDisplayPath: '.github/skills',
    userRootPath: ['.copilot', 'skills'],
    userRootDisplayPath: '~/.copilot/skills',
    capabilities: {
      supportsCatalogInstall: true,
      supportsSymlinkInstall: true,
    },
  }, params);
}

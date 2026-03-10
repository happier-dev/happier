import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createSkillMdPromptAssetAdapter } from '@/promptAssets/adapters/skillMd/createSkillMdPromptAssetAdapter';

export function createGeminiSkillPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): PromptAssetAdapter {
  return createSkillMdPromptAssetAdapter({
    assetTypeId: 'gemini.skill',
    providerId: 'gemini',
    title: 'Gemini skills (.gemini)',
    description: 'SKILL.md bundles discovered from Gemini CLI skill folders.',
    projectRootPath: ['.gemini', 'skills'],
    projectRootDisplayPath: '.gemini/skills',
    userRootPath: ['.gemini', 'skills'],
    userRootDisplayPath: '~/.gemini/skills',
    capabilities: {
      supportsCatalogInstall: true,
      supportsSymlinkInstall: true,
    },
  }, params);
}

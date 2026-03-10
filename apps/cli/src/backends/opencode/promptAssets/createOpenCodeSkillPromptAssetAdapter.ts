import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createSkillMdPromptAssetAdapter } from '@/promptAssets/adapters/skillMd/createSkillMdPromptAssetAdapter';

export function createOpenCodeSkillPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): PromptAssetAdapter {
  return createSkillMdPromptAssetAdapter({
    assetTypeId: 'opencode.skill',
    providerId: 'opencode',
    title: 'OpenCode skills (.opencode)',
    description: 'SKILL.md bundles discovered from OpenCode skill folders.',
    projectRootPath: ['.opencode', 'skills'],
    projectRootDisplayPath: '.opencode/skills',
    userRootPath: ['.config', 'opencode', 'skills'],
    userRootDisplayPath: '~/.config/opencode/skills',
    capabilities: {
      supportsCatalogInstall: true,
      supportsSymlinkInstall: true,
    },
  }, params);
}

import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createSkillMdPromptAssetAdapter } from '@/promptAssets/adapters/skillMd/createSkillMdPromptAssetAdapter';

export function createClaudeSkillPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
  happierHomeDir?: () => string;
}>): PromptAssetAdapter {
  return createSkillMdPromptAssetAdapter({
    assetTypeId: 'claude.skill',
    providerId: 'claude',
    title: 'Claude skills (.claude)',
    description: 'SKILL.md bundles discovered from Claude Code skill folders.',
    projectRootPath: ['.claude', 'skills'],
    projectRootDisplayPath: '.claude/skills',
    userRootPath: ['.claude', 'skills'],
    userRootDisplayPath: '~/.claude/skills',
    capabilities: {
      supportsCatalogInstall: true,
      supportsSymlinkInstall: true,
    },
  }, params);
}

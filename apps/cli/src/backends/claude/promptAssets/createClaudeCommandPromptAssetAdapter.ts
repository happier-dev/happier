import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createMarkdownDocPromptAssetAdapter } from '@/promptAssets/adapters/markdownDoc/createMarkdownDocPromptAssetAdapter';

export function createClaudeCommandPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
}>): PromptAssetAdapter {
  return createMarkdownDocPromptAssetAdapter({
    assetTypeId: 'claude.command',
    providerId: 'claude',
    title: 'Claude commands (.claude)',
    description: 'Markdown slash commands discovered from Claude command folders.',
    projectRootPath: ['.claude', 'commands'],
    projectRootDisplayPath: '.claude/commands',
    userRootPath: ['.claude', 'commands'],
    userRootDisplayPath: '~/.claude/commands',
    capabilities: {
      supportsNestedNamespaces: true,
    },
  }, params);
}

import type { PromptAssetAdapter } from '@/promptAssets/types';
import { createMarkdownDocPromptAssetAdapter } from '@/promptAssets/adapters/markdownDoc/createMarkdownDocPromptAssetAdapter';

export function createOpenCodeCommandPromptAssetAdapter(params?: Readonly<{
  homedir?: () => string;
}>): PromptAssetAdapter {
  return createMarkdownDocPromptAssetAdapter({
    assetTypeId: 'opencode.command',
    providerId: 'opencode',
    title: 'OpenCode commands (.opencode)',
    description: 'Markdown slash commands discovered from OpenCode command folders.',
    projectRootPath: ['.opencode', 'commands'],
    projectRootDisplayPath: '.opencode/commands',
    userRootPath: ['.config', 'opencode', 'commands'],
    userRootDisplayPath: '~/.config/opencode/commands',
    capabilities: {
      supportsNestedNamespaces: true,
    },
  }, params);
}

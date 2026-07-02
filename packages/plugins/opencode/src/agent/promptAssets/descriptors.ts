export const OPEN_CODE_COMMAND_PROMPT_ASSET_DESCRIPTOR = Object.freeze({
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
} as const);

export const OPEN_CODE_SKILL_PROMPT_ASSET_DESCRIPTOR = Object.freeze({
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
} as const);

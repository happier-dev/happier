import type {
  PluginPromptAssetContributionV1,
  PromptAssetCapabilitiesV1,
} from '@happier-dev/plugin-sdk/manifest';

export type CopilotPromptAssetConfig = Readonly<{
  assetTypeId: string;
  providerId: 'copilot';
  title: string;
  description: string;
  projectRootPath: readonly string[];
  projectRootDisplayPath: string;
  userRootPath: readonly string[];
  userRootDisplayPath: string;
  capabilities?: PromptAssetCapabilitiesV1;
}>;

export const COPILOT_SKILL_PROMPT_ASSET_CONFIG = Object.freeze({
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
} satisfies CopilotPromptAssetConfig);

export const PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([
  {
    adapterKind: 'skillMd',
    ...COPILOT_SKILL_PROMPT_ASSET_CONFIG,
  },
] as const satisfies readonly PluginPromptAssetContributionV1[]);

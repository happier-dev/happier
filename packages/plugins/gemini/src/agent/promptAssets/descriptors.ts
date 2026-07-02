import type {
  PluginPromptAssetContributionV1,
  PromptAssetCapabilitiesV1,
} from '@happier-dev/protocol';

export type GeminiPromptAssetConfig = Readonly<{
  assetTypeId: string;
  providerId: 'gemini';
  title: string;
  description: string;
  projectRootPath: readonly string[];
  projectRootDisplayPath: string;
  userRootPath: readonly string[];
  userRootDisplayPath: string;
  capabilities?: PromptAssetCapabilitiesV1;
}>;

export const GEMINI_SKILL_PROMPT_ASSET_CONFIG = Object.freeze({
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
} satisfies GeminiPromptAssetConfig);

export const PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([
  {
    adapterKind: 'skillMd',
    ...GEMINI_SKILL_PROMPT_ASSET_CONFIG,
  },
] as const satisfies readonly PluginPromptAssetContributionV1[]);

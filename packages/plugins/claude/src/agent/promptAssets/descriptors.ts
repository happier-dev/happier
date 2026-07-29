import type {
    PromptAssetCapabilities,
    PromptAssetTypeDescriptor,
} from '@happier-dev/plugin-sdk/manifest';

export type ClaudePromptAssetConfig = Readonly<{
    assetTypeId: string;
    providerId: 'claude';
    title: string;
    description: string;
    projectRootPath: readonly string[];
    projectRootDisplayPath: string;
    userRootPath: readonly string[];
    userRootDisplayPath: string;
    capabilities?: PromptAssetCapabilities;
}>;

/**
 * Host adapter configuration retained for the existing prompt-library runtime.
 * This is deliberately not a V2 manifest contribution: executable adapter
 * selection is host-owned, while manifest prompt assets are declarative
 * resources targeted at an Agent.
 */
export type ClaudePromptAssetAdapterConfig = ClaudePromptAssetConfig & Readonly<{
    adapterKind: 'markdownDoc' | 'skillMd';
}>;

export const CLAUDE_COMMAND_PROMPT_ASSET_CONFIG = {
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
} satisfies ClaudePromptAssetConfig;

export const CLAUDE_SKILL_PROMPT_ASSET_CONFIG = {
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
} satisfies ClaudePromptAssetConfig;

export const PLUGIN_PROMPT_ASSET_DESCRIPTORS = Object.freeze([
    {
        adapterKind: 'markdownDoc',
        ...CLAUDE_COMMAND_PROMPT_ASSET_CONFIG,
    },
    {
        adapterKind: 'skillMd',
        ...CLAUDE_SKILL_PROMPT_ASSET_CONFIG,
    },
] satisfies readonly ClaudePromptAssetAdapterConfig[]);

export function buildClaudeCommandPromptAssetDescriptor(): PromptAssetTypeDescriptor {
    return {
        id: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.assetTypeId,
        providerId: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.providerId,
        title: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.title,
        description: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.description,
        libraryKind: 'doc',
        supportsScope: { user: true, project: true },
        supportsFiles: false,
        formatId: 'markdown_utf8_v1',
        defaultRoots: [
            { label: 'Project commands', scope: 'project', pathTemplate: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.projectRootDisplayPath },
            { label: 'User commands', scope: 'user', pathTemplate: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.userRootDisplayPath },
        ],
        capabilities: CLAUDE_COMMAND_PROMPT_ASSET_CONFIG.capabilities,
    };
}

export function buildClaudeSkillPromptAssetDescriptor(): PromptAssetTypeDescriptor {
    return {
        id: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.assetTypeId,
        providerId: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.providerId,
        title: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.title,
        description: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.description,
        libraryKind: 'bundle',
        supportsScope: { user: true, project: true },
        supportsFiles: true,
        formatId: 'skill_md_v1',
        defaultRoots: [
            { label: 'Project skills', scope: 'project', pathTemplate: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.projectRootDisplayPath },
            { label: 'User skills', scope: 'user', pathTemplate: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.userRootDisplayPath },
        ],
        capabilities: CLAUDE_SKILL_PROMPT_ASSET_CONFIG.capabilities,
    };
}

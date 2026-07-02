import { describe, expect, it } from 'vitest';

import {
    CLAUDE_COMMAND_PROMPT_ASSET_CONFIG,
    CLAUDE_SKILL_PROMPT_ASSET_CONFIG,
    PLUGIN_PROMPT_ASSET_DESCRIPTORS,
    buildClaudeCommandPromptAssetDescriptor,
    buildClaudeSkillPromptAssetDescriptor,
} from './descriptors.js';

describe('Claude prompt asset descriptors', () => {
    it('defines Claude command assets from plugin-owned path facts', () => {
        expect(CLAUDE_COMMAND_PROMPT_ASSET_CONFIG).toMatchObject({
            assetTypeId: 'claude.command',
            providerId: 'claude',
            projectRootPath: ['.claude', 'commands'],
            userRootPath: ['.claude', 'commands'],
        });

        expect(buildClaudeCommandPromptAssetDescriptor()).toMatchObject({
            id: 'claude.command',
            providerId: 'claude',
            libraryKind: 'doc',
            defaultRoots: [
                { scope: 'project', pathTemplate: '.claude/commands' },
                { scope: 'user', pathTemplate: '~/.claude/commands' },
            ],
            capabilities: {
                supportsNestedNamespaces: true,
            },
        });
    });

    it('defines Claude skill assets from plugin-owned path facts', () => {
        expect(CLAUDE_SKILL_PROMPT_ASSET_CONFIG).toMatchObject({
            assetTypeId: 'claude.skill',
            providerId: 'claude',
            projectRootPath: ['.claude', 'skills'],
            userRootPath: ['.claude', 'skills'],
        });

        expect(buildClaudeSkillPromptAssetDescriptor()).toMatchObject({
            id: 'claude.skill',
            providerId: 'claude',
            libraryKind: 'bundle',
            formatId: 'skill_md_v1',
            defaultRoots: [
                { scope: 'project', pathTemplate: '.claude/skills' },
                { scope: 'user', pathTemplate: '~/.claude/skills' },
            ],
            capabilities: {
                supportsCatalogInstall: true,
                supportsSymlinkInstall: true,
            },
        });
    });

    it('exports inert prompt asset contribution descriptors for generated host projection', () => {
        expect(PLUGIN_PROMPT_ASSET_DESCRIPTORS).toEqual([
            expect.objectContaining({
                adapterKind: 'markdownDoc',
                assetTypeId: 'claude.command',
                providerId: 'claude',
            }),
            expect.objectContaining({
                adapterKind: 'skillMd',
                assetTypeId: 'claude.skill',
                providerId: 'claude',
            }),
        ]);
    });
});

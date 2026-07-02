import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';

describe('plugin prompt asset contributions', () => {
  it('parses inert prompt asset descriptor rows as a contribution family', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [
        {
          adapterKind: 'skillMd',
          assetTypeId: 'claude.skill',
          providerId: 'claude',
          title: 'Claude skills',
          description: 'Claude skill bundles.',
          projectRootPath: ['.claude', 'skills'],
          projectRootDisplayPath: '.claude/skills',
          userRootPath: ['.claude', 'skills'],
          userRootDisplayPath: '~/.claude/skills',
          capabilities: { supportsCatalogInstall: true },
        },
      ],
    });

    expect(parsed.promptAssets).toEqual([
      expect.objectContaining({
        adapterKind: 'skillMd',
        assetTypeId: 'claude.skill',
        providerId: 'claude',
      }),
    ]);
  });

  it('rejects unknown prompt asset adapter kinds', () => {
    expect(() =>
      PluginContributesV2Schema.parse({
        promptAssets: [
          {
            adapterKind: 'hostExecutable',
            assetTypeId: 'claude.skill',
            providerId: 'claude',
            title: 'Claude skills',
            description: 'Claude skill bundles.',
            projectRootPath: ['.claude', 'skills'],
            projectRootDisplayPath: '.claude/skills',
            userRootPath: ['.claude', 'skills'],
            userRootDisplayPath: '~/.claude/skills',
          },
        ],
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import {
  COPILOT_SKILL_PROMPT_ASSET_CONFIG,
  PLUGIN_PROMPT_ASSET_DESCRIPTORS,
} from './descriptors.js';

describe('Copilot prompt asset descriptors', () => {
  it('keeps Copilot skill path facts in the plugin leaf', () => {
    expect(COPILOT_SKILL_PROMPT_ASSET_CONFIG).toMatchObject({
      assetTypeId: 'copilot.skill',
      providerId: 'copilot',
      projectRootPath: ['.github', 'skills'],
      projectRootDisplayPath: '.github/skills',
      userRootPath: ['.copilot', 'skills'],
      userRootDisplayPath: '~/.copilot/skills',
      capabilities: {
        supportsCatalogInstall: true,
        supportsSymlinkInstall: true,
      },
    });
  });

  it('exports the host adapter descriptor without masquerading as a manifest prompt-asset declaration', () => {
    expect(PLUGIN_PROMPT_ASSET_DESCRIPTORS).toEqual([
      expect.objectContaining({
        adapterKind: 'skillMd',
        assetTypeId: 'copilot.skill',
        providerId: 'copilot',
      }),
    ]);
    expect(PLUGIN_PROMPT_ASSET_DESCRIPTORS[0]).not.toHaveProperty('resource');
    expect(PLUGIN_PROMPT_ASSET_DESCRIPTORS[0]).not.toHaveProperty('target');
  });
});

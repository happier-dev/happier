import { describe, expect, it } from 'vitest';

import {
  GEMINI_SKILL_PROMPT_ASSET_CONFIG,
  PLUGIN_PROMPT_ASSET_DESCRIPTORS,
} from './descriptors.js';

describe('Gemini prompt asset descriptors', () => {
  it('keeps Gemini skill path facts in the plugin leaf', () => {
    expect(GEMINI_SKILL_PROMPT_ASSET_CONFIG).toMatchObject({
      assetTypeId: 'gemini.skill',
      providerId: 'gemini',
      projectRootPath: ['.gemini', 'skills'],
      projectRootDisplayPath: '.gemini/skills',
      userRootPath: ['.gemini', 'skills'],
      userRootDisplayPath: '~/.gemini/skills',
      capabilities: {
        supportsCatalogInstall: true,
        supportsSymlinkInstall: true,
      },
    });
  });

  it('exports inert prompt asset contribution descriptors for generated host projection', () => {
    expect(PLUGIN_PROMPT_ASSET_DESCRIPTORS).toEqual([
      expect.objectContaining({
        adapterKind: 'skillMd',
        assetTypeId: 'gemini.skill',
        providerId: 'gemini',
      }),
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  OPEN_CODE_COMMAND_PROMPT_ASSET_DESCRIPTOR,
  OPEN_CODE_SKILL_PROMPT_ASSET_DESCRIPTOR,
} from './descriptors.js';

describe('OpenCode prompt asset descriptors', () => {
  it('describes OpenCode command and skill roots without owning prompt registry IO', () => {
    expect(OPEN_CODE_COMMAND_PROMPT_ASSET_DESCRIPTOR).toMatchObject({
      assetTypeId: 'opencode.command',
      providerId: 'opencode',
      projectRootPath: ['.opencode', 'commands'],
      userRootPath: ['.config', 'opencode', 'commands'],
      capabilities: { supportsNestedNamespaces: true },
    });

    expect(OPEN_CODE_SKILL_PROMPT_ASSET_DESCRIPTOR).toMatchObject({
      assetTypeId: 'opencode.skill',
      providerId: 'opencode',
      projectRootPath: ['.opencode', 'skills'],
      userRootPath: ['.config', 'opencode', 'skills'],
      capabilities: {
        supportsCatalogInstall: true,
        supportsSymlinkInstall: true,
      },
    });
  });
});

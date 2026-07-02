import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest';

describe('Codex plugin manifest', () => {
  it('scopes daemon spawn hooks to the Codex backend', () => {
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({
        id: 'backend.resolveRuntimePrerequisites',
        filters: { backendId: 'codex' },
      }),
      expect.objectContaining({
        id: 'spawn.augmentEnv',
        filters: { backendId: 'codex' },
      }),
    ]);
  });

  it('declares codex-acp as a plugin-owned system tool', () => {
    expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual({
      toolId: 'codex-acp',
      displayName: 'Codex ACP',
      source: 'system',
      lookupNames: ['codex-acp'],
      defaultArgs: [],
    });
  });
});

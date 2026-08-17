import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('PLUGIN_MANIFEST MCP contribution', () => {
  it('declares OpenCode config discovery through the manifest MCP family', () => {
    expect(PLUGIN_MANIFEST.contributes?.mcp?.servers).toEqual([]);
    expect(PLUGIN_MANIFEST.contributes?.mcp?.discoverySources).toEqual([
      expect.objectContaining({
        id: 'config',
        title: 'OpenCode MCP configuration',
        metadata: { agentId: 'opencode' },
      }),
    ]);
  });

  it('advertises the canonical execution-run operations', () => {
    const agent = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'opencode');

    expect(agent?.capabilities?.executionRuns).toEqual({
      open: ['create'],
      checkpoint: true,
      stop: true,
    });
  });
});

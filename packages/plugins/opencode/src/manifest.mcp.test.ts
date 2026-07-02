import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('PLUGIN_MANIFEST MCP contribution', () => {
  it('declares OpenCode config discovery through the manifest MCP family', () => {
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('mcp');
    expect(PLUGIN_MANIFEST.contributes?.mcp?.servers).toEqual([]);
    expect(PLUGIN_MANIFEST.contributes?.mcp?.discoveryProviders).toEqual([
      expect.objectContaining({
        id: 'opencode.config',
        kind: 'mcp.discoveryProvider',
        providerId: 'opencode',
      }),
    ]);
  });

  it('advertises execution-run support once C.4 wires the runtimeCore adapter', () => {
    const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === 'opencode');

    expect(backend?.capabilities?.executionRun?.supported).toBe(true);
  });
});

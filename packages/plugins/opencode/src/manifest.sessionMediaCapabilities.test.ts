import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('OpenCode plugin session media capabilities', () => {
  it('declares ACP/MCP media output through generic ACP content only', () => {
    const capabilities = capabilitiesForBackend('opencode');

    expect(capabilities.session.media.emitsSessionMedia).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      sources: ['acp-content', 'mcp-content'],
      storage: 'session-media-file',
    });
    expect(capabilities.session.media.nativeImageGeneration.supported).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/experimental/manifest/agents';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('OpenCode plugin session media capabilities', () => {
  it('does not declare persisted session-media output without an A.13j mapping leaf', () => {
    const capabilities = capabilitiesForBackend('opencode');

    expect(capabilities.session.media.emitsSessionMedia).toMatchObject({
      supported: false,
    });
    expect(capabilities.session.media.nativeImageGeneration.supported).toBe(false);
  });
});

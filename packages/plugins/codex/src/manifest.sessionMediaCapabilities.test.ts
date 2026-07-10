import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Codex plugin session media capabilities', () => {
  it('declares app-server image generation as native provider-generated session media', () => {
    const capabilities = capabilitiesForBackend('codex');

    expect(capabilities.session.media.emitsSessionMedia).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      sources: ['provider-generated'],
      storage: 'session-media-file',
    });
    expect(capabilities.session.media.nativeImageGeneration).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      streamingPartials: false,
    });
  });
});

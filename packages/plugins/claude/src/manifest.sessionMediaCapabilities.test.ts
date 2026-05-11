import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.backends?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Claude plugin session media capabilities', () => {
  it('declares SDK image blocks without claiming native image generation', () => {
    const capabilities = capabilitiesForBackend('claude');

    expect(capabilities.session.media.emitsSessionMedia).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      sources: ['provider-generated', 'tool-output'],
      storage: 'session-media-file',
    });
    expect(capabilities.session.media.nativeImageGeneration.supported).toBe(false);
  });
});

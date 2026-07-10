import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('OhMyPi plugin session media capabilities', () => {
  it('keeps session media unsupported until source-real media events are mapped', () => {
    expect(capabilitiesForBackend('ohMyPi').session.media).toEqual({
      acceptsImageInput: { supported: false },
      emitsSessionMedia: { supported: false },
      nativeImageGeneration: { supported: false },
    });
  });
});

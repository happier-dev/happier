import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Pi plugin session media capabilities', () => {
  it('declares execution-run support now that the plugin owns a strict-LF runtime backend', () => {
    const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'pi');

    expect(backend?.capabilities?.executionRun).toMatchObject({ supported: true });
  });

  it('does not claim emitted session media until plugin-owned source-real mapping lands', () => {
    const capabilities = capabilitiesForBackend('pi');

    expect(capabilities.session.media.emitsSessionMedia.supported).toBe(false);
    expect(capabilities.session.media.nativeImageGeneration.supported).toBe(false);
  });
});

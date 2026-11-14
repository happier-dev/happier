import { describe, expect, it } from 'vitest';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('notification destination picker admission', () => {
  it('admits the authored search form against the provider role input schema', () => {
    expect(() => parsePluginManifest(PLUGIN_MANIFEST)).not.toThrow();
  });
});

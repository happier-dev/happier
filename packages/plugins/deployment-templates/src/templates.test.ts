import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('bundled data-service registry source', () => {
  it('declares the inert packaged data source through the shared registry', () => {
    expect(PLUGIN_MANIFEST.contributes).toMatchObject({ registrySources: [{
      id: 'data-services', format: 'happier-catalog', kinds: ['app'],
      packageContent: { path: 'resources/registry/apps.json' },
    }] });
  });
});

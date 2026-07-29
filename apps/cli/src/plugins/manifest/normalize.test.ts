import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from './normalize';

const target = {
  schemaVersion: 2 as const,
  id: 'com.acme.plugin',
  version: '1.0.0',
  displayName: 'Acme',
  engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/plugin.js' },
  contributes: {
    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
  },
};

describe('canonical manifest normalization', () => {
  it('preserves the strict parsed contribution graph without manufacturing aliases', () => {
    const manifest = readCanonicalPluginManifest(target);
    expect(manifest?.contributes.actions).toHaveLength(1);
    expect(manifest).not.toHaveProperty('uses');
    expect(manifest?.contributes).not.toHaveProperty('agentRuntimes');
  });

  it('rejects retired behavior owners', () => {
    expect(readCanonicalPluginManifest({ ...target, uses: ['actions'] })).toBeNull();
    expect(readCanonicalPluginManifest({ ...target, entrypoints: { main: './dist/plugin.js' } })).toBeNull();
    expect(readCanonicalPluginManifest({ ...target, contributes: { embeddedWebBundles: [] } })).toBeNull();
  });
});

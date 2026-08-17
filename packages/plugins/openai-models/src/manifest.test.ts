import { describe, expect, it } from 'vitest';

import {
  ingestPluginManifestV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginManifestV2Schema,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenAI provider plugin manifest', () => {
  it('is declarative, permission-free, and contributes the migration-stable provider id', async () => {
    await expect(import('./manifest.js').then((module) =>
      PluginManifestV2Schema.parse(module.PLUGIN_MANIFEST))).resolves.toMatchObject({
      id: 'happier.provider.openai',
      hostAccess: { required: [], optional: [] },
      contributes: { providers: [{ id: 'openai' }] },
    });
  });

  it('uses only the strict data-only root and survives bundled or installed ingestion', () => {
    expect(Object.keys(PLUGIN_MANIFEST).sort()).toEqual([
      'contributes', 'description', 'displayName', 'engines', 'hostAccess', 'id', 'runtime', 'schemaVersion', 'version',
    ]);
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toEqual(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST)));
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST).ok).toBe(true);
  });

  it('keeps providers delegated to the first-class provider domain without runtime registration', () => {
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'providers');
    expect(family).toMatchObject({ identityKind: 'delegatedDomain', stability: 'delegated', disposition: 'delegated', activationDemand: 'conditional', allowedRuntimeRegistration: 'providers' });
    expect(family?.projectIntrospection(PLUGIN_MANIFEST.contributes.providers[0])).toMatchObject({ localId: null, stability: 'delegated', registration: 'notRequired' });
  });
});

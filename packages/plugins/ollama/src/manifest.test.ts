import { describe, expect, it } from 'vitest';

import {
  ingestPluginManifestV2,
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PluginManifestV2Schema,
} from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Ollama plugin manifest', () => {
  it('declares only the exact Ollama process authority used by its public managed runtime', async () => {
    await expect(import('./manifest.js').then((module) => PluginManifestV2Schema.parse(module.PLUGIN_MANIFEST))).resolves.toMatchObject({
      id: 'happier.provider.ollama',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: {
        required: [{
          id: 'ollama-process',
          capability: 'process',
          scope: { executables: [{ kind: 'systemTool', id: 'ollama-cli' }] },
        }],
        optional: [],
      },
      contributes: {
        providers: [{ id: 'ollama', managedRuntime: { kind: 'managed' } }],
        systemTools: [{ id: 'ollama-cli', executableNames: ['ollama'] }],
      },
    });
  });

  it('uses only the strict data-only root and survives bundled or installed ingestion', () => {
    expect(Object.keys(PLUGIN_MANIFEST).sort()).toEqual([
      'contributes', 'description', 'displayName', 'engines', 'entrypoints', 'hostAccess', 'id', 'runtime', 'schemaVersion', 'version',
    ]);
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toEqual(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST)));
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST).ok).toBe(true);
  });

  it('keeps the managed Provider registration conditional on its declaration', () => {
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'providers');
    expect(family).toMatchObject({ identityKind: 'delegatedDomain', disposition: 'delegated' });
    expect(family?.projectIntrospection(PLUGIN_MANIFEST.contributes.providers[0])).toMatchObject({
      localId: null,
      registration: 'required',
    });
  });
});

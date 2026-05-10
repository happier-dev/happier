import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from './validate';

const validatePluginManifestWithOptions = validatePluginManifest as (
  input: unknown,
  options?: { allowReservedHappierPluginId?: boolean },
) => ReturnType<typeof validatePluginManifest>;

function createManifest(id: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: `Plugin ${id}`,
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1, capabilities: [] },
    targets: {},
    capabilities: { permissions: [] },
    contributes: {},
  };
}

describe('validatePluginManifest', () => {
  it('rejects external manifests that claim the reserved happier namespace', () => {
    const result = validatePluginManifest(createManifest('happier.agent.fake'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_semantic_invalid',
          message: expect.stringContaining('reserved'),
        }),
      ]);
    }
  });

  it('allows bundled first-party manifests to use the reserved happier namespace', () => {
    const result = validatePluginManifestWithOptions(createManifest('happier.agent.codex'), {
      allowReservedHappierPluginId: true,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects duplicate id-less lifecycle declarations for the same event', () => {
    const manifest = createManifest('acme.lifecycle');
    manifest.runtime = { apiVersion: 1, capabilities: ['lifecycle'] };
    manifest.targets = { daemon: { entry: './daemon.mjs' } };
    manifest.contributes = {
      lifecycleHandlers: [
        {
          event: 'activated',
          handler: { target: 'daemon', registrationId: 'activated.first' },
        },
        {
          event: 'activated',
          handler: { target: 'daemon', registrationId: 'activated.second' },
        },
      ],
    };

    const result = validatePluginManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_semantic_invalid',
          message: expect.stringContaining('id-less lifecycle handler'),
        }),
      ]);
    }
  });
});

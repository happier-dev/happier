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
    engines: { happier: '>=0.2.0 <1.0.0' },
    uses: [],
    entrypoints: { main: './daemon.mjs' },
    permissions: { required: [], optional: [] },
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

  it('rejects lifecycle declarations without stable ids', () => {
    const manifest = createManifest('acme.lifecycle');
    manifest.uses = ['lifecycle'];
    manifest.contributes = {
      lifecycleHandlers: [
        {
          event: 'activated',
          handler: { target: 'daemon', registrationId: 'activated' },
        },
      ],
    };

    const result = validatePluginManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_semantic_invalid',
          message: expect.stringContaining('stable id'),
        }),
      ]);
    }
  });

  it('rejects conditional backend surface operations without an availability evaluator for the same surface', () => {
    const manifest = createManifest('acme.conditional-surface');
    manifest.uses = ['agents'];
    manifest.contributes = {
      agents: [
        {
          kindVersion: 1,
          id: 'acme.conditional-surface.backend',
          runtime: { kind: 'custom' },
          capabilities: { executionRun: { supported: false } },
          surfaceHandlers: [
            {
              surfaceApiVersion: 1,
              id: 'checkpoint-restore',
              kind: 'checkpoint',
              operation: 'restore',
              support: 'conditional',
              handler: {
                target: 'daemon',
                exportName: 'restore',
              },
            },
          ],
        },
      ],
    };

    const result = validatePluginManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_semantic_invalid',
          message: expect.stringMatching(/conditional.*evaluateAvailability/i),
        }),
      ]);
    }
  });

  it('accepts conditional backend surface operations with a matching availability evaluator', () => {
    const manifest = createManifest('acme.conditional-surface-ready');
    manifest.uses = ['agents'];
    manifest.contributes = {
      agents: [
        {
          kindVersion: 1,
          id: 'acme.conditional-surface-ready.backend',
          runtime: { kind: 'custom' },
          capabilities: { executionRun: { supported: false } },
          surfaceHandlers: [
            {
              surfaceApiVersion: 1,
              id: 'checkpoint-availability',
              kind: 'checkpoint',
              operation: 'evaluateAvailability',
              handler: {
                target: 'daemon',
                exportName: 'evaluateCheckpointAvailability',
              },
            },
            {
              surfaceApiVersion: 1,
              id: 'checkpoint-restore',
              kind: 'checkpoint',
              operation: 'restore',
              support: 'conditional',
              handler: {
                target: 'daemon',
                exportName: 'restore',
              },
            },
          ],
        },
      ],
    };

    expect(validatePluginManifest(manifest)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('accepts full npm semver ranges for engines.happier', () => {
    const manifest = createManifest('acme.semver');
    manifest.engines = { happier: '~0.2.0 || >=0.3.0 <1.0.0' };

    expect(validatePluginManifest(manifest)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('reports a named syntax diagnostic for invalid engines.happier ranges', () => {
    const manifest = createManifest('acme.invalid-semver');
    manifest.engines = { happier: 'not a semver range' };

    const result = validatePluginManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_engine_range_invalid',
          message: expect.stringContaining('engines.happier'),
        }),
      ]);
    }
  });

  it('reports the failing JSON path for nested manifest schema errors', () => {
    const manifest = createManifest('acme.invalid-action-surfaces');
    manifest.uses = ['actions'];
    manifest.contributes = {
      actions: [
        {
          kindVersion: 1,
          id: 'acme.invalid-action-surfaces.list',
          title: 'List notes',
          scopes: ['global'],
          surfaces: 'cli',
          placement: 'commandPalette',
          handler: { target: 'daemon', exportName: 'listNotes' },
          dangerLevel: 'safe',
        },
      ],
    };

    const result = validatePluginManifest(manifest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          message: expect.stringContaining('contributes.actions[0].surfaces:'),
        }),
      ]);
    }
  });
});

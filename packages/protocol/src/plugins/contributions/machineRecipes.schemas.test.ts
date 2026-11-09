import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2, resolvePluginManifestSetReferencesV2 } from '../manifest/ingest.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2, derivePluginDaemonContributionRegistrationRights } from './catalog.js';

const pluginId = 'com.example.machine-setup';
const recipe = { id: 'fonts', revision: '1', title: 'Fonts', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }] };
const preset = { id: 'browser-bot', revision: '1', title: 'Browser bot', description: 'Fonts for bot tools', setup: { items: [{
  kind: 'softwareRecipe', selection: { ref: { pluginId, recipeId: 'fonts', revision: '1' }, inputs: {} },
}] } };
const manifest = (recipes: readonly unknown[] = [recipe], presets: readonly unknown[] = [preset], id = pluginId) => ({
  schemaVersion: 2, id, version: '1.0.0', displayName: 'Machine setup', runtime: { apiVersion: 1 },
  contributes: { machineRecipes: recipes, machineSetupPresets: presets },
});

describe('public Machine setup data families', () => {
  it('admits both strict declarations through the manifest without runtime registration', () => {
    const result = ingestPluginManifestV2(manifest());
    expect(result).toMatchObject({ ok: true, manifest: { contributes: { machineRecipes: [recipe], machineSetupPresets: [preset] } } });
    if (!result.ok) throw new Error('Expected admitted Machine setup data');
    expect(derivePluginDaemonContributionRegistrationRights(result.manifest.contributes)).toEqual([]);
    for (const family of ['machineRecipes', 'machineSetupPresets']) {
      const entry = PLUGIN_CONTRIBUTION_CATALOG_V2.find(candidate => candidate.manifestKey === family);
      expect(entry).toMatchObject({ identityField: 'id', activationDemand: 'none', consumer: 'machine-recipe-catalog', allowedRuntimeRegistration: null });
      expect(entry?.projectJsonSchema()).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('refuses callback, module, script and open-input recipe payloads and duplicate identity', () => {
    for (const invalid of [{ ...recipe, callback: 'run' }, { ...recipe, module: './native.js' }, { ...recipe, setupScript: 'id' },
      { ...recipe, inputSchema: { type: 'object' } }, { ...recipe, steps: [{ id: 'native', kind: 'command', executable: 'id', args: [] }] }]) {
      expect(ingestPluginManifestV2(manifest([invalid])).ok).toBe(false);
    }
    expect(ingestPluginManifestV2(manifest([recipe, recipe])).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest([recipe], [{ ...preset, creation: {} }])).ok).toBe(false);
  });

  it('rejects missing same-plugin recipe identities and revisions with canonical diagnostics', () => {
    for (const ref of [{ pluginId, recipeId: 'missing', revision: '1' }, { pluginId, recipeId: 'fonts', revision: '2' }]) {
      expect(ingestPluginManifestV2(manifest([recipe], [{ ...preset, setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] } }])))
        .toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({
          code: 'plugin_manifest_dangling_reference', path: ['contributes', 'machineSetupPresets', 0, 'setup', 'items', 0, 'selection', 'ref'],
        })]) });
    }
    const wrongFamily = { ...preset, setup: { items: [{ kind: 'softwareRecipe', selection: {
      ref: { pluginId, recipeId: 'browser-bot', revision: '1' }, inputs: {},
    } }] } };
    expect(ingestPluginManifestV2(manifest([recipe], [wrongFamily]))).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' }),
    ]) });
  });

  it('resolves qualified cross-plugin references only at their exact declaration revision', () => {
    const externalPreset = { ...preset, setup: { items: [{ kind: 'softwareRecipe', selection: { ref: { pluginId, recipeId: 'fonts', revision: '1' }, inputs: {} } }] } };
    const supplier = ingestPluginManifestV2(manifest([recipe], []));
    const consumer = ingestPluginManifestV2(manifest([], [externalPreset], 'com.example.consumer'));
    expect(supplier.ok && consumer.ok).toBe(true);
    if (!supplier.ok || !consumer.ok) throw new Error('Expected independently admitted manifests');
    expect(resolvePluginManifestSetReferencesV2([supplier.manifest, consumer.manifest])).toEqual({ ok: true });
    const replacement = ingestPluginManifestV2(manifest([{ ...recipe, revision: '2' }], []));
    if (!replacement.ok) throw new Error('Expected replacement recipe declaration');
    expect(resolvePluginManifestSetReferencesV2([replacement.manifest, consumer.manifest])).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({ pluginId: 'com.example.consumer', code: 'plugin_manifest_dangling_reference' }),
    ]) });
  });
});
